import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { announcePwaUpdate } from './lib/pwaUpdate'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = Boolean(navigator.serviceWorker.controller)
  let refreshing = false

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return
    refreshing = true
    window.location.reload()
  })

  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
    updateViaCache: 'none',
  }).then((registration) => {
    const offerUpdate = (worker: ServiceWorker) => {
      if (!navigator.serviceWorker.controller) return
      announcePwaUpdate(() => worker.postMessage({ type: 'SKIP_WAITING' }))
    }

    if (registration.waiting) offerUpdate(registration.waiting)

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      if (!worker) return
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') offerUpdate(worker)
      })
    })

    registration.update().catch(() => undefined)
  }).catch(() => {
    // The app remains usable online when service workers are unavailable.
  })
}
