export type DisplayHintWindowSnapshot={key:string;scrollTop:number;influencesScrollTop:number;collapsedSections?:string[]}|null;

/** View history owns these transient windows; no reading state is changed. */
export function createDisplayHintWindow() {
  let visible:DisplayHintWindowSnapshot=null,pending:DisplayHintWindowSnapshot=null,version=0;
  const listeners=new Set<()=>void>(),emit=()=>listeners.forEach(listener=>listener());
  const clone=(value:DisplayHintWindowSnapshot)=>value?{...value,...(value.collapsedSections?{collapsedSections:[...value.collapsedSections]}:{})}:null;
  return {
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    getSnapshot:()=>visible,
    capture:()=>clone(pending??visible),
    open(key:string){version++;pending=null;if(visible?.key!==key){visible={key,scrollTop:0,influencesScrollTop:0};emit();}},
    close(key:string){if(visible?.key===key){version++;visible=null;pending=null;emit();}},
    scroll(key:string,scrollTop:number,influencesScrollTop:number){if(visible?.key===key){visible.scrollTop=scrollTop;visible.influencesScrollTop=influencesScrollTop;}},
    toggleSection(key:string,section:string){if(visible?.key===key){const collapsed=new Set(visible.collapsedSections);if(collapsed.has(section))collapsed.delete(section);else collapsed.add(section);visible={...visible,collapsedSections:[...collapsed]};emit();}},
    suspend(){pending=clone(visible);visible=null;const token=++version;emit();return token;},
    finishNavigation(token:number){if(version===token)pending=null;},
    restore(snapshot:DisplayHintWindowSnapshot){version++;pending=null;visible=clone(snapshot);emit();},
    clear(){version++;pending=null;visible=null;emit();},
  };
}
export type DisplayHintWindow=ReturnType<typeof createDisplayHintWindow>;
