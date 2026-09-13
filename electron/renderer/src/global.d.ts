import type { MaestroBridge } from '../../preload/index.js';

declare global {
  interface Window {
    maestro: MaestroBridge;
  }
}

export {};
