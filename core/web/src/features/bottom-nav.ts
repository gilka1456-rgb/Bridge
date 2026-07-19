import type { TabId } from "../models/types";
import { iconSvg, type IconName } from "./icons";

const ITEMS: Array<{ id: TabId; label: string; icon: IconName }> = [
  { id: "discover", label: "看见", icon: "eye" },
  { id: "avatars", label: "虚像", icon: "avatar" },
  { id: "place", label: "放置", icon: "plus" },
  { id: "records", label: "记录", icon: "image" },
  { id: "mine", label: "我的", icon: "user" },
];

export function bottomNavHtml(activeTab: TabId): string {
  return ITEMS.map(({ id, label, icon }) => {
    const active = activeTab === id ? "active" : "";
    const center = id === "place" ? "bottom-nav-center" : "";
    return `
      <button type="button" data-tab="${id}" class="bottom-nav-item ${center} ${active}" aria-label="${label}" ${active ? 'aria-current="page"' : ""}>
        <span class="bottom-nav-icon">${iconSvg(icon)}</span>
        <span class="bottom-nav-label">${label}</span>
      </button>
    `;
  }).join("");
}
