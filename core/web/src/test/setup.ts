import "fake-indexeddb/auto";
import { beforeEach } from "vitest";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
