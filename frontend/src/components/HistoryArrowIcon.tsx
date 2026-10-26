export default function HistoryArrowIcon({direction}:{direction:'back'|'forward'}) {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={direction==='back'?'M19 12H5m7 7-7-7 7-7':'M5 12h14m-7-7 7 7-7 7'} />
  </svg>;
}
