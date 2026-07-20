import { useEffect, useId, useRef, type ReactNode } from 'react'

export function Modal({ title, children, onClose, urgent = false, className = '' }: { title: string; children: ReactNode; onClose?: () => void; urgent?: boolean; className?: string }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    const backdrop = dialog?.parentElement
    const appShell = backdrop?.parentElement
    const background = appShell
      ? Array.from(appShell.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      : []
    const previousOverflow = document.body.style.overflow
    const backgroundState = background.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }))
    background.forEach((element) => {
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    })
    document.body.style.overflow = 'hidden'
    const first = dialog?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) onClose()
      if (event.key !== 'Tab' || !dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const firstFocusable = focusable[0]
      const lastFocusable = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === firstFocusable || !dialog.contains(active))) {
        event.preventDefault()
        lastFocusable.focus()
      } else if (!event.shiftKey && (active === lastFocusable || !dialog.contains(active))) {
        event.preventDefault()
        firstFocusable.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      backgroundState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      })
      document.body.style.overflow = previousOverflow
      previous?.focus()
    }
  }, [onClose])

  return (
    <div className={`modalBackdrop ${className}`} role="presentation">
      <div ref={dialogRef} className="modal" role={urgent ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
