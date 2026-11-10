/** Shared voting interaction for review, truth and value arbitration. */
export default function ArbitrationVoteForm({direction,onDirection,options,amount,onAmount,minimum=1,busy=false,voting=false,onVote}:{
  direction:string;onDirection:(value:string)=>void;options:readonly {value:string;label:string}[];
  amount:number|string;onAmount:(value:string)=>void;minimum?:number;busy?:boolean;voting?:boolean;onVote:()=>void;
}){
  return <div className="flex items-center gap-2">
    <select aria-label="投票方向" value={direction} onChange={event=>onDirection(event.target.value)} disabled={busy}
      className="text-xs border border-[color:var(--line-d1d5db)] rounded px-2 py-1.5 flex-1 bg-[color:var(--surface-card)] text-[color:var(--text-primary)]">
      {options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <input aria-label="投票投入点数" type="number" min={minimum} step={1} value={amount} onChange={event=>onAmount(event.target.value)} disabled={busy}
      className="w-16 text-xs border border-[color:var(--line-d1d5db)] rounded px-2 py-1.5 text-center bg-[color:var(--surface-card)] text-[color:var(--text-primary)]"/>
    <button type="button" onClick={onVote} disabled={busy}
      className="record-action px-3 py-1.5 bg-[color:var(--surface-4f46e5)] hover:bg-[color:var(--surface-4338ca)] disabled:bg-[color:var(--surface-a5b4fc)] text-[color:var(--ink-fff-2)] text-xs font-medium rounded transition-colors">
      {voting?'投票中...':'投票'}
    </button>
  </div>;
}
