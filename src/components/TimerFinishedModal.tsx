import { useEffect } from 'react'
import { Icon } from './Icon'
import { Modal } from './Modal'

function playFinishSignal() {
  try {
    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AudioContextClass) {
      const context = new AudioContextClass()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(740, context.currentTime)
      oscillator.frequency.exponentialRampToValueAtTime(980, context.currentTime + 0.35)
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.65)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.7)
    }
  } catch {
    // Visual notice remains the primary signal when audio is unavailable.
  }
  try {
    navigator.vibrate?.([180, 90, 180])
  } catch {
    // Vibration is optional.
  }
}

export function TimerFinishedModal({ onClose }: { onClose: () => void }) {
  useEffect(playFinishSignal, [])
  return (
    <Modal title="Время закончилось" urgent className="timerFinished">
      <div className="timerFinished__icon"><Icon name="clock" /></div>
      <p>Сессия завершена. Пора отложить телефон и выбрать новое приключение.</p>
      <button type="button" className="button button--primary" onClick={onClose}>Понятно</button>
    </Modal>
  )
}
