import type { Ref, ReactNode } from 'react';
import type { DemoMessage, UnitSelection } from '../../utils/modelBridge';
import type { Relation } from '../../types';
import type { GraphViewProps } from '../GraphView';
import { getMessageProminence } from '../../utils/messageDisplay';
import { isMessageElementSelected, messageMembersReference, messageTypeReference } from '../../utils/messageElementSelection';
import { activateMessageFromKeyboard } from '../../utils/messageKeyboard';
import MessageTextPart from '../MessageTextPart';
import MessageElement from '../MessageElement';
import { MessageDisplayMarker } from '../MessageDisplayHints';
import MessageSettlementActions from '../MessageSettlementActions';
import JoinRecordBadges from '../JoinRecordBadges';

type CardCallbacks = Pick<GraphViewProps, 'onMessageClick' | 'onMessageDoubleClick' | 'onMessageMouseDown' | 'onMessageMouseUp' | 'onTextMouseUp' | 'onSettlementToggleTruth' | 'onSettlementToggleValue' | 'onJoinFilterClick' | 'settlementOpenMsgId' | 'settlementOpenType'>;
interface ClassificationCardProps extends CardCallbacks {
  msg: DemoMessage;
  selectedUnits: readonly UnitSelection[];
  box: { x: number; y: number; width: number };
  targetCount: number;
  title: string;
  activeText: boolean;
  isWhole: boolean;
  isActive: boolean;
  isStanceTarget: boolean;
  homeLabel: string | null;
  stakes?: { truth: { pro: number; con: number }; value: { pro: number; con: number } };
  relatedJoinRelations: Relation[];
  outgoingJoinRelations: Relation[];
  isJoinEffective: (record: Relation) => boolean;
  cardRef: Ref<HTMLDivElement>;
  headerRef: Ref<HTMLDivElement>;
  contentRef: Ref<HTMLDivElement>;
  relatedMessages?:ReactNode;
  correctionRecords?:ReactNode;
}

/** Classification presentation shares the card's click/double-click surface with its title. */
export default function ClassificationCard({
  msg, selectedUnits, box, targetCount, title, activeText, isWhole, isActive, isStanceTarget,
  homeLabel, stakes, relatedJoinRelations, outgoingJoinRelations, isJoinEffective,
  cardRef, headerRef, contentRef, relatedMessages, correctionRecords, onMessageClick, onMessageDoubleClick, onMessageMouseDown, onMessageMouseUp,
  onTextMouseUp, onSettlementToggleTruth, onSettlementToggleValue, onJoinFilterClick, settlementOpenMsgId, settlementOpenType,
}: ClassificationCardProps) {
  const prominence = getMessageProminence(msg);
  return (
              <div key={msg.id} data-msgid={msg.id} ref={cardRef}
                role="group" tabIndex={0} aria-label={`分类 ${msg.id}，${isWhole ? '已选中' : '未选中'}`}
                aria-keyshortcuts="Enter Space Shift+Enter" onKeyDown={activateMessageFromKeyboard}
                onClick={e=>onMessageClick(e,msg.id)} onDoubleClick={e=>onMessageDoubleClick(e,msg.id)}
                onMouseDown={e=>onMessageMouseDown?.(e,msg.id)} onMouseUp={e=>onMessageMouseUp?.(e,msg.id)}
                style={{position:"absolute",left:box.x,top:box.y,width:box.width,boxSizing:"border-box",backgroundColor:isStanceTarget?"#2a2410":isWhole?"#4a3510":"#1f1f1f",borderRadius:6,
                  borderTop:isWhole?"2px solid #fbbf24":isStanceTarget?"2px solid #f59e0b":isActive?"1px solid rgba(56,189,248,0.8)":"1px solid #444",
                  borderRight:isWhole?"2px solid #fbbf24":isStanceTarget?"2px solid #f59e0b":isActive?"1px solid rgba(56,189,248,0.8)":"1px solid #444",
                  borderBottom:isWhole?"2px solid #fbbf24":isStanceTarget?"2px solid #f59e0b":isActive?"1px solid rgba(56,189,248,0.8)":"1px solid #444",
                  borderLeft:"3px solid #a78bfa",
                  padding:"12px 16px",boxShadow:isStanceTarget?"0 0 16px rgba(245,158,11,0.35), 0 4px 10px rgba(0,0,0,0.5)":isWhole?"0 8px 20px rgba(251,191,36,0.28)":isActive?"0 6px 16px rgba(56,189,248,0.14)":"0 4px 10px rgba(0,0,0,0.5)",display:"flex",flexDirection:"column",
                  gap:8,cursor:"pointer",outline:isWhole?"none":isActive?"1px dashed #0b84ff":"none",userSelect:"none",color:"#f5f5f5",backgroundImage:isWhole?undefined:prominence.backgroundImage}}>
                <div ref={headerRef} style={{fontSize:11,opacity:0.85,display:"flex",flexWrap:"wrap",gap:6,alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:6}}>
                    <MessageElement reference={messageTypeReference(msg)} selected={isMessageElementSelected(selectedUnits, messageTypeReference(msg))} label="分类" style={{fontSize:10,fontWeight:800,padding:"2px 6px",borderRadius:4,background:isWhole?"#fbbf24":"rgba(167,139,250,0.18)",color:isWhole?"#111827":"#a78bfa",lineHeight:"16px",border:isWhole?"1px solid #fbbf24":"1px solid rgba(167,139,250,0.35)"}}>分类</MessageElement>
                    {homeLabel && <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,background:homeLabel==='命中'?"#0e7490":"#374151",color:homeLabel==='命中'?"#cffafe":"#d1d5db"}}>{homeLabel}</span>}
                    <span>{msg.author}</span>
                    {correctionRecords}
                  </span>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,maxWidth:'100%',marginLeft:'auto'}}>
                    <span style={{display:'inline-flex',alignItems:'center',maxWidth:'100%'}}><span style={{overflowWrap:'anywhere'}}>{msg.id}</span><MessageDisplayMarker messageId={msg.id} /></span>
                    <MessageSettlementActions messageId={msg.id} counts={stakes}
                      openMessageId={settlementOpenMsgId} openType={settlementOpenType}
                      onTruth={onSettlementToggleTruth} onValue={onSettlementToggleValue} />
                  </div>
                </div>
                <div ref={contentRef} style={{display:"flex",flexDirection:"column",gap:4}}>
                  {activeText && <div style={{fontSize:11,color:'#0b84ff',marginBottom:4}}>拖选文字即可选择片段，或点击已有高亮片段</div>}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                    <div style={{fontSize:prominence.fontSize,fontWeight:600,color:"#f3f4f6",flex:1,minWidth:0,whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
                      <MessageTextPart message={msg} activeText={activeText} onMouseUp={onTextMouseUp}>{activeText && msg.parts ? undefined : title}</MessageTextPart>
                    </div>
                  </div>
                  <div style={{fontSize:12,color:"#9ca3af",display:"flex",gap:12,flexWrap:"wrap"}}>
                    <MessageElement reference={messageMembersReference(msg)} selected={isMessageElementSelected(selectedUnits, messageMembersReference(msg))} label="所含消息">💬 {targetCount} 条观点</MessageElement>
                    <span>{new Date(msg.createdAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>

              <JoinRecordBadges messageId={msg.id} memberRecords={relatedJoinRelations} containerRecords={outgoingJoinRelations}
                isContainer isEffective={isJoinEffective} onOpen={onJoinFilterClick}/>
                {relatedMessages}
              </div>
            );
}
