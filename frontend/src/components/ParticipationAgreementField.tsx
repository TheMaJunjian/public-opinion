import { useId } from 'react';
import { PARTICIPATION_AGREEMENT_PATH } from '@gonglun/core';

export default function ParticipationAgreementField({ checked, onChange }: {
  checked: boolean; onChange: (value: boolean) => void;
}) {
  const id = useId();
  return <div className="flex items-center gap-2 text-sm">
    <input id={id} type="checkbox" aria-labelledby={`${id}-label ${id}-agreement`} checked={checked} onChange={event => onChange(event.target.checked)} />
    <div>
      <label id={`${id}-label`} htmlFor={id}>我已阅读并同意</label>
      <a id={`${id}-agreement`} href={PARTICIPATION_AGREEMENT_PATH} target="_blank" rel="noopener noreferrer"
        className="text-[color:var(--ink-60a5fa-2)] underline">《公论参与协议》</a>
    </div>
  </div>;
}
