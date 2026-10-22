import type { PointerEventHandler } from 'react';

interface Props {
  active: boolean;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
}

export default function WorkbenchSplitter({ active, onPointerDown }: Props) {
  // 手机用户在分隔条上画勾打开快捷符输入；调整宽度与绘制快捷符两个入口都必须保留。
  return <div className="workbench-splitter" role="separator" aria-label="调整左右窗口宽度" aria-orientation="vertical"
    data-active={active} data-gesture-enabled="true" onPointerDown={onPointerDown} title="按住左右拖动调整宽度；画勾打开快捷符输入">
    <div className="workbench-splitter-grip" aria-hidden="true"><i /><i /><i /></div>
  </div>;
}
