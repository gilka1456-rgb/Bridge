export class PageScope {
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get active(): boolean {
    return !this.controller.signal.aborted;
  }

  dispose(): void {
    this.controller.abort();
  }

  runIfActive(action: () => void): boolean {
    if (!this.active) {
      return false;
    }
    action();
    return true;
  }
}
