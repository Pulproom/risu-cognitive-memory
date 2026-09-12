import { createHash } from "node:crypto";
import { estimateTokens, type McpQuestionAnswer, type McpSourceMetadata, type McpSourceRange, type MemoryContextItem } from "@rcm/shared";
import type { RcmDatabase } from "./db.js";
import type { SemanticSearchResult, SemanticSourceHit } from "./embedding.js";
import { memoryAtomKey, memoryDetailAtomKey, memoryDialogueAtomKey } from "./memory-atoms.js";
import { evidenceRanker } from "./mcp-evidence.js";
import { presentationOnlySourcePassage } from "./source-evidence.js";

type Source = { message_id:string;canonical_content:string;canonical_hash:string;ordinal:number;role:string };
type Located = { source:Source;start:number;end:number;score:number;memoryId?:string };
type SourcePassage = { text:string;start:number;end:number;contiguous:boolean };
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");

function sentenceRanges(text:string,offset=0):Array<{start:number;end:number}>{
  try{return [...new Intl.Segmenter(undefined,{granularity:"sentence"}).segment(text)].flatMap(segment=>{
    const leading=segment.segment.search(/\S/u);if(leading<0)return[];
    return [{start:offset+segment.index+leading,end:offset+segment.index+segment.segment.trimEnd().length}];
  });}catch{return [...text.matchAll(/\S[\s\S]*?(?:[.!?。！？]+(?=\s|$)|$)/gu)].map(match=>({start:offset+match.index!,end:offset+match.index!+match[0].trimEnd().length}));}
}

function sentenceWindow(source:Source,start:number,end:number,paragraphStart:number,paragraphEnd:number,ceiling:number):SourcePassage|undefined{
  const sentences=sentenceRanges(source.canonical_content.slice(paragraphStart,paragraphEnd),paragraphStart);
  let first=sentences.findIndex(sentence=>sentence.end>start);let last=-1;
  for(let index=sentences.length-1;index>=0;index--)if(sentences[index]!.start<end){last=index;break;}
  if(first<0)return; if(last<first)last=first;
  const text=()=>source.canonical_content.slice(sentences[first]!.start,sentences[last]!.end);
  while(true){
    const candidates=[first>0?{first:first-1,last}:undefined,last+1<sentences.length?{first,last:last+1}:undefined]
      .filter((candidate):candidate is {first:number;last:number}=>Boolean(candidate))
      .map(candidate=>({...candidate,value:source.canonical_content.slice(sentences[candidate.first]!.start,sentences[candidate.last]!.end)}))
      .filter(candidate=>estimateTokens(candidate.value)<=ceiling).sort((left,right)=>left.value.length-right.value.length);
    const next=candidates[0];if(!next)break;first=next.first;last=next.last;
  }
  const value=text();return value?{text:value,start:sentences[first]!.start,end:sentences[last]!.end,contiguous:true}:undefined;
}

function paragraphsAround(source:Source,start:number,end:number,ceiling:number):SourcePassage|undefined {
  const paragraphs=[...source.canonical_content.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)];
  let first=paragraphs.findIndex(part=>part.index!+part[0].length>start);
  let last=paragraphs.length-1;
  while(last>=0&&paragraphs[last]!.index!>=end)last--;
  if(first<0||last<first)return;
  const bounds=()=>({start:paragraphs[first]!.index!,end:paragraphs[last]!.index!+paragraphs[last]![0].length});
  const text=()=>{const range=bounds();return source.canonical_content.slice(range.start,range.end);};
  // Keep paragraph boundaries even when the semantic chunk is larger than the
  // display ceiling. The later span pass selects short sentence-safe excerpts.
  if(estimateTokens(text())>ceiling){const range=bounds();return sentenceWindow(source,start,end,range.start,range.end,ceiling);}
  for(const direction of [-1,1] as const){
    const next=direction<0?first-1:last+1;
    if(next<0||next>=paragraphs.length||presentationOnlySourcePassage(paragraphs[next]![0]))continue;
    const old=direction<0?first:last;
    if(direction<0)first=next;else last=next;
    if(estimateTokens(text())>ceiling){if(direction<0)first=old;else last=old;}
  }
  const range=bounds();
  // Keep the exact canonical slice. Removing presentation-only paragraphs here
  // would concatenate text and make later relative offsets point at the wrong
  // source position. The span pass skips those paragraphs while retaining
  // source coordinates for the excerpts it does select.
  const raw=text();
  const leading=raw.search(/\S/u);if(leading<0)return;
  const trimmed=raw.trimEnd();
  return {text:trimmed.slice(leading),start:range.start+leading,end:range.start+trimmed.length,contiguous:true};
}

function rangesOverlap(left:McpSourceRange,right:McpSourceRange):boolean {
  return left.messageId===right.messageId&&Math.max(left.start,right.start)<Math.min(left.end,right.end);
}

function citationMetadata(db:RcmDatabase,chatId:string,source:Source,sourceRange:McpSourceRange):McpSourceMetadata[] {
  const rows=db.prepare(`SELECT locations_json,evidence_json FROM memory_details
    WHERE chat_id=? AND active=1 AND EXISTS(
      SELECT 1 FROM json_each(evidence_json) WHERE json_extract(value,'$.messageId')=?)`)
    .all(chatId,source.message_id) as Array<{locations_json:string;evidence_json:string}>;
  const annotations=new Map<string,McpSourceMetadata>();
  for(const row of rows){
    let locations:string[];let citations:Array<{messageId?:string;quote?:string}>;
    try { locations=JSON.parse(row.locations_json||"[]");citations=JSON.parse(row.evidence_json||"[]"); } catch { continue; }
    // A list of locations is scene-level context, not a precise source label.
    // Surface it only when this directly cited detail names exactly one place.
    if(locations.length!==1||typeof locations[0]!=="string"||!locations[0].trim())continue;
    for(const citation of citations){
      if(citation.messageId!==source.message_id||!citation.quote)continue;
      const start=source.canonical_content.indexOf(citation.quote);
      if(start<0||source.canonical_content.indexOf(citation.quote,start+1)>=0)continue;
      const range={messageId:source.message_id,start,end:start+citation.quote.length};
      if(!rangesOverlap(range,sourceRange))continue;
      annotations.set(`${range.messageId}:${range.start}:${range.end}:${locations[0]}`,{sourceRange:range,location:locations[0].trim()});
    }
  }
  return [...annotations.values()];
}

/** Materializes an indexed transcript hit only while its current canonical block
 * identity and exact substring remain valid. */
function locateSourceHit(db:RcmDatabase,chatId:string,hit:SemanticSourceHit,source:(id:string)=>Source|undefined):Located[] {
  const chunk=db.prepare(`SELECT e.content,e.content_hash,b.content_hash AS block_hash,b.message_ids_json
    FROM embedding_items e JOIN embedding_blocks b ON b.id=e.block_id AND b.chat_id=e.chat_id
    WHERE e.chat_id=? AND e.item_id=? AND e.kind='transcript_chunk' AND b.status='indexed'`).get(chatId,hit.chunkId) as
    {content:string;content_hash:string;block_hash:string;message_ids_json:string}|undefined;
  if(!chunk||hash(chunk.content)!==chunk.content_hash)return [];
  const rows=(JSON.parse(chunk.message_ids_json) as string[]).map(source);
  if(rows.some(row=>!row)||hash(rows.map(row=>`${row!.message_id}\0${row!.canonical_hash}`).join("\0"))!==chunk.block_hash)return [];
  const markers=rows.flatMap(row=>{const marker=`[${row!.message_id}] ${row!.role.toUpperCase()}:\n`;const index=chunk.content.indexOf(marker);
    return index>=0?[{row:row!,index,length:marker.length}]:[];}).sort((a,b)=>a.index-b.index);
  return markers.flatMap((marker,index)=>{
    const piece=chunk.content.slice(marker.index+marker.length,markers[index+1]?.index!==undefined?markers[index+1]!.index-2:chunk.content.length);
    const start=marker.row.canonical_content.indexOf(piece);
    return piece.trim()&&start>=0&&marker.row.canonical_content.indexOf(piece,start+1)<0
      ?[{source:marker.row,start,end:start+piece.length,score:hit.score}]:[];
  });
}

/** Adds direct transcript and atom-bound source candidates. It does not decide
 * which candidate answers the question; the MCP evidence reranker does that. */
export function appendMcpSourceContext(db:RcmDatabase,chatId:string,answers:McpQuestionAnswer[],items:MemoryContextItem[],
  semantic:SemanticSearchResult[],tokenBudget:number,query:string,promptSourceMessageIds:string[]=[]):{anchors:number;unmapped:number;windows:number;sourceCandidates:number;coherenceRemoved:number} {
  const promptSources=new Set(promptSourceMessageIds);
  const read=db.prepare(`SELECT message_id,canonical_content,canonical_hash,ordinal,role FROM messages WHERE chat_id=? AND message_id=?
    AND lifecycle IN ('committed','client_pruned') AND host_visibility IN ('active','all_before')`);
  const cache=new Map<string,Source|undefined>();
  const source=(id:string)=>{
    if(!cache.has(id)){
      const row=read.get(chatId,id) as Source|undefined;
      cache.set(id,typeof row?.canonical_content==="string"&&row.canonical_content ? row : undefined);
    }
    return cache.get(id);
  };
  const locatedCache=new Map<string,Located[]>();
  const materialize=(hit:SemanticSourceHit)=>{
    if(!locatedCache.has(hit.chunkId))locatedCache.set(hit.chunkId,locateSourceHit(db,chatId,hit,source));
    return locatedCache.get(hit.chunkId)!.map(position=>({...position,score:hit.score}));
  };
  let anchors=0,unmapped=0,windows=0,sourceCandidates=0,coherenceRemoved=0;
  const ceiling=Math.min(520,Math.max(140,Math.floor(tokenBudget/Math.max(3,answers.length*2))));
  const fullHits=[...(semantic[0]?.sourceHits??[])].filter(hit=>hit.score>=.35).sort((a,b)=>b.score-a.score);

  answers.forEach((answer,index)=>{
    const view=semantic[answers.length>1?index+1:0]??semantic[0];
    const focusHits=[...(view?.sourceHits??[])].filter(hit=>hit.score>=.35).sort((a,b)=>b.score-a.score);
    const fullPosition=new Map(fullHits.map((hit,rank)=>[hit.chunkId,rank]));
    const focusPosition=new Map(focusHits.map((hit,rank)=>[hit.chunkId,rank]));
    const pool=[...new Map([...focusHits.slice(0,16),...fullHits.slice(0,24)].map(hit=>[hit.chunkId,hit])).values()];
    const located=pool.flatMap(hit=>materialize(hit).map(position=>({position,hit})))
      .filter(({position})=>!promptSources.has(position.source.message_id));
    sourceCandidates+=located.length;
    const passages=located.map(({position})=>paragraphsAround(position.source,position.start,position.end,ceiling));
    const texts=passages.map(passage=>passage?.text??"");
    const focusRank=evidenceRanker(answer.question,texts);
    const fullRank=evidenceRanker(query,texts);
    const ranked=located.map((candidate,candidateIndex)=>{
      const text=texts[candidateIndex]!;
      const focusIndex=focusPosition.get(candidate.hit.chunkId);
      const fullIndex=fullPosition.get(candidate.hit.chunkId);
      const score=focusRank(text)*.5+fullRank(text)*.2
        +(focusIndex===undefined?0:.2/(focusIndex+1))+(fullIndex===undefined?0:.1/(fullIndex+1))+candidate.hit.score*.08;
      return {...candidate,passage:passages[candidateIndex],text,score};
    }).filter(candidate=>candidate.text).sort((a,b)=>b.score-a.score||b.hit.score-a.hit.score);
    const boundSourceBundles=new Set<string>();
    for(const candidate of ranked.slice(0,8)){
      const position=candidate.position;
      if(answer.evidence.some(evidence=>evidence.text.includes(candidate.text)||candidate.text.includes(evidence.text)))continue;
      const sourceItems=items.filter(item=>item.evidenceMessageIds.includes(position.source.message_id));
      const relatedItem=sourceItems.find(item=>answer.evidence.some(evidence=>evidence.memoryId===item.id))??sourceItems[0];
      const relatedEvidence=relatedItem&&answer.evidence.find(evidence=>evidence.memoryId===relatedItem.id);
      const key=relatedEvidence?.bundleKey??`source:${position.source.message_id}:${position.start}`;
      if(relatedEvidence&&boundSourceBundles.has(key))continue;
      if(relatedEvidence)boundSourceBundles.add(key);
      const sourceRange=candidate.passage?.contiguous?{messageId:position.source.message_id,start:candidate.passage.start,end:candidate.passage.end}:undefined;
      answer.evidence.push({atomKey:memoryAtomKey("source",hash(position.source.message_id+position.source.canonical_hash+candidate.text),candidate.text),
        bundleKey:key,memoryId:relatedItem?.id,kind:"quote",text:candidate.text,knownBy:[],basis:"archive context",
        context:relatedItem?.title,sourceRange,
        sourceMetadata:sourceRange?citationMetadata(db,chatId,position.source,sourceRange):undefined});
      windows++;
    }

    for(const evidence of [...answer.evidence]){
      if(evidence.kind==="quote"&&evidence.basis==="archive context")continue;
      const item=items.find(candidate=>candidate.id===evidence.memoryId);
      if(!item)continue;
      const positions:Located[]=[];
      const detail=item.details.find(candidate=>memoryDetailAtomKey(candidate)===evidence.atomKey);
      if(detail){
        const row=db.prepare("SELECT evidence_json FROM memory_details WHERE chat_id=? AND id=? AND active=1").get(chatId,detail.id) as {evidence_json:string}|undefined;
        for(const citation of JSON.parse(row?.evidence_json??"[]") as Array<{messageId?:string;quote?:string}>){
          if(!citation.messageId||!citation.quote)continue;
          if(promptSources.has(citation.messageId))continue;
          const current=source(citation.messageId);const start=current?.canonical_content.indexOf(citation.quote)??-1;
          if(current&&start>=0&&current.canonical_content.indexOf(citation.quote,start+1)<0)positions.push({source:current,start,end:start+citation.quote.length,score:1,memoryId:item.id});else unmapped++;
        }
      }
      const dialogue=item.keyDialogues.find(candidate=>memoryDialogueAtomKey(item.id,candidate)===evidence.atomKey);
      if(dialogue&&!promptSources.has(dialogue.messageId)){const current=source(dialogue.messageId);const start=current?.canonical_content.indexOf(dialogue.text)??-1;
        if(current&&start>=0&&current.canonical_content.indexOf(dialogue.text,start+1)<0)positions.push({source:current,start,end:start+dialogue.text.length,score:1,memoryId:item.id});else unmapped++;}
      anchors+=positions.length;
      const position=positions[0];if(!position)continue;
      const passage=paragraphsAround(position.source,position.start,position.end,ceiling);const text=passage?.text;
      if(!passage||!text||text===evidence.text||answer.evidence.some(old=>old.text.includes(text)))continue;
      const key=evidence.bundleKey??evidence.atomKey;evidence.bundleKey=key;
      const sourceRange=passage.contiguous?{messageId:position.source.message_id,start:passage.start,end:passage.end}:undefined;
      answer.evidence.push({atomKey:memoryAtomKey("source",hash(position.source.message_id+position.source.canonical_hash+text),text),bundleKey:key,
        memoryId:item.id,kind:"quote",text,knownBy:[],basis:"archive context",
        context:item.title,sourceRange,
        sourceMetadata:sourceRange?citationMetadata(db,chatId,position.source,sourceRange):undefined});
      windows++;
    }
  });
  return {anchors,unmapped,windows,sourceCandidates,coherenceRemoved};
}
