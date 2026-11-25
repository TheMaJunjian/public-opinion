import type { ReviewVerdict } from '@gonglun/core';

export default function ReviewVerdictIcon({verdict}:{verdict:ReviewVerdict}){
  return <svg data-review-verdict-icon={verdict} aria-hidden="true" focusable="false"
    width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
    {verdict==='pass'
      ? <><path d="M2 12c2.5-4.2 6-6.5 10-6.5s7.5 2.3 10 6.5c-2.5 4.2-6 6.5-10 6.5S4.5 16.2 2 12Z"/>
          <circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/></>
      : <><path d="M2 9c2.8 3.6 6.2 5.4 10 5.4S19.2 12.6 22 9"/>
          <path d="m6.2 12.8-2.1 3M12 14.4V18m5.8-5.2 2.1 3"/></>}
  </svg>;
}
