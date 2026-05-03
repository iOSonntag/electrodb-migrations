import yoctoSpinner, { type Spinner as YoctoSpinner } from 'yocto-spinner';

/**
 * Stable wrapper API around yocto-spinner. CLI-08.
 *
 * Decouples consumers from yocto-spinner's exact surface so a future spinner
 * swap (e.g. back to `ora`) does not ripple through every command file.
 * yocto-spinner writes to stderr by default; the wrapper does not change that.
 */
export interface Spinner {
  start(): void;
  setText(text: string): void;
  success(finalText?: string): void;
  error(finalText?: string): void;
  stop(): void;
}

export function createSpinner(initialText: string): Spinner {
  const sp: YoctoSpinner = yoctoSpinner({ text: initialText });
  return {
    start: () => {
      sp.start();
    },
    setText: (text) => {
      sp.text = text;
    },
    success: (finalText) => {
      sp.success(finalText);
    },
    error: (finalText) => {
      sp.error(finalText);
    },
    stop: () => {
      sp.stop();
    },
  };
}
