import { focusManager } from './focusManager'
import { onlineManager } from './onlineManager'
import { sleep } from './utils'
import { CancelOptions, NetworkMode } from './types'

// TYPES

interface RetryerConfig<TData = unknown, TError = unknown> {
  fn: () => TData | Promise<TData>
  abort?: () => void
  onError?: (error: TError) => void
  onSuccess?: (data: TData) => void
  onFail?: (failureCount: number, error: TError) => void
  onPause?: () => void
  onContinue?: () => void
  retry?: RetryValue<TError>
  retryDelay?: RetryDelayValue<TError>
  networkMode: NetworkMode | undefined
}

export interface Retryer<TData = unknown> {
  promise: Promise<TData>
  cancel: (cancelOptions?: CancelOptions) => void
  continue: () => void
  cancelRetry: () => void
  continueRetry: () => void
}

export type RetryValue<TError> = boolean | number | ShouldRetryFunction<TError>

type ShouldRetryFunction<TError> = (
  failureCount: number,
  error: TError
) => boolean

export type RetryDelayValue<TError> = number | RetryDelayFunction<TError>

type RetryDelayFunction<TError = unknown> = (
  failureCount: number,
  error: TError
) => number

function defaultRetryDelay(failureCount: number) {
  return Math.min(1000 * 2 ** failureCount, 30000)
}

export function canFetch(networkMode: NetworkMode | undefined): boolean {
  return (networkMode ?? 'online') === 'online'
    ? onlineManager.isOnline()
    : true
}

export class CancelledError {
  revert?: boolean
  silent?: boolean
  constructor(options?: CancelOptions) {
    this.revert = options?.revert
    this.silent = options?.silent
  }
}

export function isCancelledError(value: any): value is CancelledError {
  return value instanceof CancelledError
}

class PromiseCompleter<TData, TError> {
  promise: Promise<TData>
  resolve!: (data: TData) => void
  reject!: (error: TError) => void
  isResolved = false

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = (data: TData) => {
        if (this.isResolved) {
          return
        }
        const result = resolve(data)
        this.isResolved = true
        return result
      }
      this.reject = reject
    })
  }
}

export function createRetryer<TData = unknown, TError = unknown>(
  config: RetryerConfig<TData, TError>
): Retryer<TData> {
  let isRetryCancelled = false
  let failureCount = 0
  let isResolved = false
  let continueFn: ((value?: unknown) => void) | undefined
  const completer = new PromiseCompleter<TData, TError>()

  const cancel = (cancelOptions?: CancelOptions): void => {
    if (!isResolved) {
      reject(new CancelledError(cancelOptions))

      config.abort?.()
    }
  }
  const cancelRetry = () => {
    isRetryCancelled = true
  }

  const continueRetry = () => {
    isRetryCancelled = false
  }

  const shouldPause = () =>
    !focusManager.isFocused() ||
    (config.networkMode !== 'always' && !onlineManager.isOnline())

  const resolve = (value: any) => {
    if (!isResolved) {
      isResolved = true
      config.onSuccess?.(value)
      continueFn?.()
      completer.resolve(value)
    }
  }

  const reject = (value: any) => {
    if (!isResolved) {
      isResolved = true
      config.onError?.(value)
      continueFn?.()
      completer.reject(value)
    }
  }

  const pause = () => {
    return new Promise(continueResolve => {
      continueFn = value => {
        if (isResolved || !shouldPause()) {
          return continueResolve(value)
        }
      }
      config.onPause?.()
    }).then(() => {
      continueFn = undefined
      if (!isResolved) {
        config.onContinue?.()
      }
    })
  }

  // Create loop function
  const run = () => {
    // Do nothing if already resolved
    if (isResolved) {
      return
    }

    let promiseOrValue: any

    // Execute query
    try {
      promiseOrValue = config.fn()
    } catch (error) {
      promiseOrValue = Promise.reject(error)
    }

    Promise.resolve(promiseOrValue)
      .then(resolve)
      .catch(error => {
        // Stop if the fetch is already resolved
        if (isResolved) {
          return
        }

        // Do we need to retry the request?
        const retry = config.retry ?? 3
        const retryDelay = config.retryDelay ?? defaultRetryDelay
        const delay =
          typeof retryDelay === 'function'
            ? retryDelay(failureCount, error)
            : retryDelay
        const shouldRetry =
          retry === true ||
          (typeof retry === 'number' && failureCount < retry) ||
          (typeof retry === 'function' && retry(failureCount, error))

        if (isRetryCancelled || !shouldRetry) {
          // We are done if the query does not need to be retried
          reject(error)
          return
        }

        failureCount++

        // Notify on fail
        config.onFail?.(failureCount, error)

        // Delay
        sleep(delay)
          // Pause if the document is not visible or when the device is offline
          .then(() => {
            if (shouldPause()) {
              return pause()
            }
          })
          .then(() => {
            if (isRetryCancelled) {
              reject(error)
            } else {
              run()
            }
          })
      })
  }

  // Start loop
  if (canFetch(config.networkMode)) {
    run()
  } else {
    pause().then(run)
  }

  return {
    promise: completer.promise,
    cancel,
    continue: () => {
      continueFn?.()
    },
    cancelRetry,
    continueRetry,
  }
}
