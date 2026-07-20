export type PwaUpdateAction = () => void

type PwaUpdateListener = (action: PwaUpdateAction) => void

let pendingAction: PwaUpdateAction | null = null
const listeners = new Set<PwaUpdateListener>()

export function announcePwaUpdate(action: PwaUpdateAction) {
  pendingAction = action
  listeners.forEach((listener) => listener(action))
}

export function subscribePwaUpdate(listener: PwaUpdateListener) {
  listeners.add(listener)
  if (pendingAction) listener(pendingAction)

  return () => {
    listeners.delete(listener)
  }
}

export function dismissPwaUpdate() {
  pendingAction = null
}
