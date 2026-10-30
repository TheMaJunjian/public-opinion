export type DisplayHintWindowSnapshot={key:string;scrollTop:number;influencesScrollTop:number;collapsedSections?:string[];toggledSections?:string[];ownerId?:string}|null;

/** View history owns these transient windows; no reading state is changed. */
export function createDisplayHintWindow() {
  let visible:DisplayHintWindowSnapshot=null,pending:DisplayHintWindowSnapshot=null,version=0;
  const listeners=new Set<()=>void>(),emit=()=>listeners.forEach(listener=>listener());
  const clone=(value:DisplayHintWindowSnapshot)=>value?{...value,...(value.collapsedSections?{collapsedSections:[...value.collapsedSections]}:{}),...(value.toggledSections?{toggledSections:[...value.toggledSections]}:{})}:null;
  return {
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    getSnapshot:()=>visible,
    capture:()=>clone(pending??visible),
    open(key:string,ownerId?:string){version++;pending=null;if(visible?.key!==key){visible={key,scrollTop:0,influencesScrollTop:0,collapsedSections:['automatic','read-influences','members-read','legend'],ownerId};emit();}
      else if(visible.ownerId!==ownerId){visible={...visible,ownerId};emit();}},
    close(key:string){if(visible?.key===key){version++;visible=null;pending=null;emit();}},
    scroll(key:string,scrollTop:number,influencesScrollTop:number){if(visible?.key===key){visible.scrollTop=scrollTop;visible.influencesScrollTop=influencesScrollTop;}},
    toggleSection(key:string,section:string,currentlyOpen?:boolean){if(visible?.key===key){const collapsed=new Set(visible.collapsedSections);if(currentlyOpen??!collapsed.has(section))collapsed.add(section);else collapsed.delete(section);visible={...visible,collapsedSections:[...collapsed],toggledSections:[...new Set([...(visible.toggledSections??[]),section])]};emit();}},
    suspend(){pending=clone(visible);visible=null;const token=++version;emit();return token;},
    finishNavigation(token:number){if(version===token)pending=null;},
    restore(snapshot:DisplayHintWindowSnapshot){version++;pending=null;visible=clone(snapshot);if(visible)delete visible.ownerId;emit();},
    clear(){version++;pending=null;visible=null;emit();},
  };
}
export type DisplayHintWindow=ReturnType<typeof createDisplayHintWindow>;
