export function reportValueLabel(value: string) {
  const words = value.trim().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
  if (!words) return "Unspecified";
  return `${words.charAt(0).toLocaleUpperCase("en-US")}${words.slice(1)}`;
}
