const PRECISE_LOCATION_PATTERN =
  /(?:\d{2,}|(?:号|栋|单元|室|楼|座|门牌)|[-+]?\d{1,3}\.\d{3,}\s*[,，]\s*[-+]?\d{1,3}\.\d{3,})/;

/**
 * Public posts must not inherit a precise private capture location.
 * Keep broad human labels (for example a park or district), but replace
 * addresses, room numbers and coordinates with a deliberately vague label.
 */
export function defaultPublicLocation(locationLabel: string): string {
  const location = locationLabel.trim();
  if (!location || PRECISE_LOCATION_PATTERN.test(location)) {
    return "附近";
  }
  return location.slice(0, 24);
}

export function validatePublicLocation(value: string): string {
  const location = value.trim() || "附近";
  if (PRECISE_LOCATION_PATTERN.test(location)) {
    throw new Error("公开地点不能包含门牌、房间号或精确坐标，请填写公园、街区等模糊位置。");
  }
  return location.slice(0, 24);
}
