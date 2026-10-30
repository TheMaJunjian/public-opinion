import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ComponentProps} from 'react';
import RelationToolbar,{RelationChoices} from '../pages/workbench/ui/RelationToolbar';
import WorkbenchViewToolbar from '../pages/workbench/ui/WorkbenchViewToolbar';
import {ALL_RELATION_TYPES} from '../pages/workbench/model/relationComposition';
import {relationTypeName} from '../utils/graphTextSelection';
import {setTheme,type ThemeLayout} from '../theme/theme';

const override=vi.hoisted(()=>({layout:undefined as ThemeLayout|undefined}));
vi.mock('../theme/theme',async importOriginal=>{
  const original=await importOriginal<typeof import('../theme/theme')>();
  return {...original,useThemeSettings:()=>{
    const settings=original.useThemeSettings();
    return override.layout?{...settings,layout:override.layout}:settings;
  }};
});

const originalClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
const readText=vi.fn(async()=> 'known-message');
beforeEach(()=>{
  // The same appearance exercises all layouts, so controls cannot infer placement from its ID.
  setTheme('gpt');readText.mockClear();
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText}});
});
afterEach(()=>{
  cleanup();override.layout=undefined;localStorage.clear();
  delete document.documentElement.dataset.theme;delete document.documentElement.dataset.appearance;
  if(originalClipboard)Object.defineProperty(navigator,'clipboard',originalClipboard);else Reflect.deleteProperty(navigator,'clipboard');
});

function Controls({onJump}:{onJump:(id:string)=>void}) {
  const composer:ComponentProps<typeof RelationToolbar>['composer']={
    relationType:null,secondaryRelationType:'none',newMessageContent:'尚未发送的正文',subType:null,
    setRelationType:vi.fn(),setSecondaryRelationType:vi.fn(),setNewMessageContent:vi.fn(),
    lastTagSecondaryRef:{current:'recommend'},lastDelegationSecondaryRef:{current:'create'},
    savedTextOnTypeSwitchRef:{current:''},subTypeCustomBufferRef:{current:''},guideTargetIdRef:{current:null},
  };
  const props:ComponentProps<typeof WorkbenchViewToolbar>={
    top:0,scopeMessageId:'root',exportTitle:'公论',showAlert:vi.fn(),onJump,
    home:{mode:null,onChange:vi.fn()},filter:{settings:{hideJoin:false,hideSettlement:true},onChange:vi.fn()},
    clean:{active:false,filters:[],matchCount:0,totalCount:0,onAdd:vi.fn(),onRemove:vi.fn(),onUpdate:vi.fn(),onClear:vi.fn()},
    view:{viewMode:'list',setViewMode:vi.fn(),leftPanelRef:{current:null},viewModeScrollRef:{current:{graph:null,list:null}},
      draftUnits:[],targetUnits:[],traceCount:0,currentClassifyRelMsgId:null,
      messages:[{id:'known-message',kind:'normal',content:'消息',author:'用户',createdAt:''}],relations:[],
      findContainingClassification:()=>null,exitClassification:vi.fn(),enterClassification:vi.fn(),scheduleViewNavigation:vi.fn()},
    comparison:{comparisonMode:false,comparisonReviewed:false,comparisonTargetId:null,setComparisonTargetId:vi.fn(),onStartComparison:vi.fn()},
    correctionFilterTargetId:null,onLeaderboard:vi.fn(),
  };
  return <>
    <div data-testid="toolbar"><RelationToolbar barRef={null} leftControlsRef={{current:null}} rightControlsRef={{current:null}}
      top={0} springWidth={0} rightOffset={16} viewer={false} messageIdInput="known-message" onMessageIdChange={vi.fn()}
      onJump={()=>onJump('known-message')} composer={composer}/></div>
    <WorkbenchViewToolbar {...props}/>
    <div data-testid="desk"><RelationChoices placement="desk" composer={composer}/></div>
  </>;
}

it.each<ThemeLayout>([
  {messageJump:'inline',relationControls:'toolbar'},
  {messageJump:'clipboard-dialog',relationControls:'desk'},
  {messageJump:'inline',relationControls:'desk'},
  {messageJump:'clipboard-dialog',relationControls:'toolbar'},
])('independently places $messageJump navigation and $relationControls relations without changing their actions',async layout=>{
  override.layout=layout;const onJump=vi.fn();render(<Controls onJump={onJump}/>);
  const chosen=within(screen.getByTestId(layout.relationControls)),other=within(screen.getByTestId(layout.relationControls==='toolbar'?'desk':'toolbar'));
  for(const type of ALL_RELATION_TYPES){
    const name=relationTypeName(type);
    expect(chosen.getAllByRole('button',{name})).toHaveLength(1);
    expect(other.queryByRole('button',{name})).toBeNull();
  }
  if(layout.messageJump==='inline'){
    expect(screen.getByRole('textbox',{name:'消息 ID'})).toHaveValue('known-message');
    expect(screen.queryByRole('button',{name:'跳转'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'确认'}));
    expect(readText).not.toHaveBeenCalled();
  }else{
    expect(screen.queryByRole('textbox',{name:'消息 ID'})).toBeNull();
    const jump=screen.getByRole('button',{name:'跳转'});
    expect(screen.getByRole('button',{name:'导出'}).nextElementSibling).toBe(jump);
    fireEvent.click(jump);
    await waitFor(()=>expect(readText).toHaveBeenCalledOnce());
  }
  await waitFor(()=>expect(onJump).toHaveBeenCalledExactlyOnceWith('known-message'));
});
