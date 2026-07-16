import "fake-indexeddb/auto";
import { beforeEach } from "vitest";

let objectUrlSequence = 0;

if (!URL.createObjectURL) {
  URL.createObjectURL = () => `blob:bridge-test-${objectUrlSequence += 1}`;
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = () => undefined;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
