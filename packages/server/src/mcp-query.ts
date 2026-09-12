/** Keeps a short event discriminator for dependent facets such as "the reply"
 * without copying a long compound request into every search instruction. */
export function mcpEventScope(query:string,maxCharacters=240):string{
  const compact=query.replace(/\s+/gu," ").trim();
  const prefix=compact.slice(0,maxCharacters+1);
  const sentence=prefix.match(/^.*?[.!?。！？](?=\s|$)/u)?.[0];
  if(sentence&&sentence.length>=48)return sentence;
  if(compact.length<=maxCharacters)return compact;
  const boundary=prefix.lastIndexOf(" ");
  return prefix.slice(0,boundary>=48?boundary:maxCharacters).trim();
}

export function mcpFacetSearchQuery(overall:string,facet:string):string{
  const scope=mcpEventScope(overall);
  if(!scope||scope.localeCompare(facet,undefined,{sensitivity:"base"})===0)return facet;
  return `Requested detail: ${facet}\nEvent: ${scope}`;
}
