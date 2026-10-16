import {fireEvent,render} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import RelatedMessages from '../components/RelatedMessages';
import {indexRelatedMessages} from '../utils/relatedMessages';
import {PART_SELECTION_EVENT} from '../utils/messageElementSelection';
import type {DemoMessage} from '../utils/modelBridge';
const source:DemoMessage={id:'category',revision:1,kind:'relation',relationType:'classify',author:'用户',createdAt:'',content:'分类',relationPayload:{title:'旧分类'},targetRefs:[],declaredTargetRefs:[{kind:'message',messageId:'claim'}],parts:[{id:'organization',type:'relation',relation:'classify',roles:{members:[{id:'member',reference:{messageId:'claim'}}]}}],state:{messageId:'category',revision:1,suppressed:true,supportCount:0,oppositionCount:1,recommendationTotal:0}};
it('shows and selects the rejected container part on its former member',()=>{
 const rows=indexRelatedMessages([source]).get('claim'),selection=vi.fn(),navigate=vi.fn();window.addEventListener(PART_SELECTION_EVENT,selection);
 const view=render(<RelatedMessages rows={rows} onNavigate={navigate}/>);
 const toggle=view.getByRole('button',{name:/被反对的容器：1/});
 expect(toggle.getAttribute('aria-expanded')).toBe('false');
 expect(view.queryByText('分类 · 旧分类')).toBeNull();
 fireEvent.click(toggle);
 expect(toggle.getAttribute('aria-expanded')).toBe('true');
 expect(view.getByText('分类 · 旧分类')).toBeTruthy();
 fireEvent.click(view.getByRole('button',{name:'选择被反对的分类消息部件'}));
 expect(selection.mock.calls[0][0].detail.reference).toEqual({messageId:'category',revision:1,partId:'organization'});
 view.rerender(<RelatedMessages rows={rows} onNavigate={navigate} selectedUnits={[{messageId:'category',selection:{kind:'whole'},reference:{messageId:'category',revision:1,partId:'organization'}}]}/>);
 expect(view.getByRole('button',{name:'选择被反对的分类消息部件'}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(view.getByRole('button',{name:'查看'}));expect(navigate).toHaveBeenCalledWith('category');
 fireEvent.click(toggle);
 expect(view.queryByRole('button',{name:'查看'})).toBeNull();
 fireEvent.click(toggle);
 expect(view.getByRole('button',{name:'选择被反对的分类消息部件'}).getAttribute('aria-pressed')).toBe('true');
 window.removeEventListener(PART_SELECTION_EVENT,selection);
});
it('does not repeat agreement or round records that already have graph presentations',()=>{
 const vote={...source,id:'vote',relationType:'agree' as const},round={...source,id:'round',kind:'round' as const,relationType:undefined};
 expect(indexRelatedMessages([vote,round]).size).toBe(0);
});
it('restores rejected containers related through old JOIN and native membership parts, even with no current members',()=>{
 const empty={...source,targetRefs:[],declaredTargetRefs:[],parts:[]};
 const join:DemoMessage={id:'join',kind:'join',author:'用户',createdAt:'',content:'加入',sourceMessageId:'category',joinInfo:{containerId:'category',containerType:'CLASSIFY',targetIds:['claim']},targetRefs:[{kind:'message',messageId:'claim'}]};
 expect(indexRelatedMessages([empty,join]).get('claim')?.map(row=>row.message.id)).toEqual(['category']);
 const membership:DemoMessage={...join,id:'native',targetRefs:[],joinInfo:undefined,sourceMessageId:undefined,parts:[{id:'membership',type:'relation',relation:'member-of',roles:{parent:[{id:'p',reference:{messageId:'category'}}],member:[{id:'m',reference:{messageId:'claim'}}]}}]};
 expect(indexRelatedMessages([empty,membership]).get('claim')?.map(row=>row.message.id)).toEqual(['category']);
 expect(indexRelatedMessages([source],new Set()).size).toBe(0);
 expect(indexRelatedMessages([{...source,state:undefined}],new Set(['category'])).get('claim')).toHaveLength(1);
});

it('keeps both rejected ancestor containers discoverable on a released leaf',()=>{
 const inner={...source,id:'inner'},outer={...source,id:'outer',parts:[],declaredTargetRefs:[{kind:'relation' as const,relationId:'inner'}]};
 expect(indexRelatedMessages([inner,outer]).get('claim')?.map(row=>row.message.id)).toEqual(['inner','outer']);
});
