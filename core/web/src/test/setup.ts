import "fake-indexeddb/auto";
import { beforeEach } from "vitest";

let objectUrlSequence = 0;

URL.createObjectURL = () => `blob:bridge-test-${objectUrlSequence += 1}`;
URL.revokeObjectURL = () => undefined;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.replaceChildren();
});
