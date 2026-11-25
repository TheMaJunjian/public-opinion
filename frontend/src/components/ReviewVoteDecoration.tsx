import { useEffect, type CSSProperties } from 'react';
import { reviewVoteBadgeWidth, reviewVoteLabel, reviewVoteLoadLabels, type ReviewVoteGroup, type ReviewVoteWindow } from '../utils/reviewRecords';
import MessageElement from './MessageElement';
import PromptModal from './PromptModal';
import ReviewVerdictIcon from './ReviewVerdictIcon';

export function ReviewVoteLoadStatus({label,targetId,onLoad,style,...anchors}:{
  label:string;targetId:string;onLoad?:(id:string)=>void;style?:CSSProperties;
  'data-jump-visual-msgids'?:string;'data-frame-edge-id'?:string;
}){
  useEffect(()=>{
    if(label===reviewVoteLoadLabels.idle)onLoad?.(targetId);
  },[label,targetId,onLoad]);
  if(label===reviewVoteLoadLabels.error)return <button type="button" data-rel-overlay="true" {...anchors} style={style}
    onClick={event=>{event.stopPropagation();onLoad?.(targetId);}}>{label}</button>;
  return <span role="status" data-rel-overlay="true" {...anchors} style={style}>{reviewVoteLoadLabels.loading}</span>;
}

export function ReviewVoteBadge({group,onOpen,style,pending,...anchors}:{group:ReviewVoteGroup;onOpen?:(group:ReviewVoteGroup)=>void;style?:CSSProperties;pending?:boolean;
  'data-jump-visual-msgids'?:string;'data-frame-edge-id'?:string}){
  const pass=group.verdict==='pass';
  const label=`查看${reviewVoteLabel(group.verdict)}投票记录（${group.votes.length} 票）`;
  return <button type="button" {...anchors} data-skin-decoration="review" data-skin-operation={pass?'green':'red'}
    data-review-vote-badge={group.verdict} data-jump-msgids={group.votes.map(vote=>vote.id).join(' ')} data-rel-overlay="true" data-pending={pending||undefined}
    aria-label={label} title={label} onMouseDown={e=>e.stopPropagation()} onMouseUp={e=>e.stopPropagation()}
    onClick={e=>{e.stopPropagation();onOpen?.(group);}} onDoubleClick={e=>e.stopPropagation()}
    style={{display:'inline-flex',alignItems:'center',justifyContent:'center',boxSizing:'border-box',
      minWidth:reviewVoteBadgeWidth(group.votes.length),height:18,padding:'0 4px',border:'1px solid var(--line-rgba-255-255-255-0-15)',borderRadius:3,
      background:'var(--surface-card)',fontSize:12,lineHeight:1,whiteSpace:'nowrap',cursor:'pointer',...style}}>
    <span style={{display:'inline-flex',alignItems:'center',gap:3,fontVariantNumeric:'tabular-nums',
      color:pass?'var(--ink-4ade80)':'var(--ink-f87171)'}}>
      <ReviewVerdictIcon verdict={group.verdict}/>{pass?'通过':'不通过'} {group.votes.length}
    </span>
  </button>;
}

export function ReviewVoteDialog({group,onClose,voteWindow,onStance}:{group?:ReviewVoteGroup;onClose:()=>void;voteWindow?:ReviewVoteWindow;
  onStance:(vote:ReviewVoteGroup['votes'][number],kind:'agree'|'disagree')=>void}){
  if(!group)return null;
  const canPrepare=(vote:ReviewVoteGroup['votes'][number])=>vote.revision&&voteWindow
    &&(!vote.round||vote.round===voteWindow.round)&&(!voteWindow.releaseAt||Date.now()<Date.parse(voteWindow.releaseAt));
  return <PromptModal open title="审核投票记录" closeOnly onConfirm={onClose} onCancel={onClose} message={
    <ul aria-label={reviewVoteLabel(group.verdict)} style={{margin:0,padding:0,listStyle:'none',display:'grid',gap:12}}>
      {group.votes.map(vote=><li key={vote.id} data-review-vote-id={vote.id} style={{display:'grid',gap:4,overflowWrap:'anywhere'}}>
        <strong>{vote.author} · {reviewVoteLabel(group.verdict)}</strong>
        <span>押注 {vote.wager??'未知'} 点 · 原文版本 {vote.targetRevision??'未记录'}{vote.round!==undefined&&` · 第 ${vote.round} 轮`}</span>
        <time dateTime={vote.createdAt}>{vote.createdAt}</time>
        <MessageElement label={`审核投票 ${vote.id}`} reference={{messageId:vote.id,revision:vote.revision}}>{vote.id}</MessageElement>
        {canPrepare(vote)&&<div style={{display:'flex',gap:6}}>
          {(['agree','disagree'] as const).map(kind=><button type="button" key={kind} aria-label={`${kind==='agree'?'赞同':'反对'}这条审核投票`}
            onClick={()=>{if(canPrepare(vote))onStance(vote,kind);}}>{kind==='agree'?'赞同':'反对'}</button>)}
        </div>}
      </li>)}
    </ul>}/>;
}
