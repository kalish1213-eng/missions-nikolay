export function ProgressBar({ value, label, tone = 'violet' }: { value: number; label: string; tone?: 'violet' | 'lime' | 'orange' }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="progressBar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}%`}>
      <div className="progressBar__fill" data-tone={tone} style={{ width: `${percent}%` }} />
    </div>
  )
}
