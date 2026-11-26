function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86400);
  if (days > 0) return days + "d " + hours + "h " + minutes + "m";
  if (hours > 0) return hours + "h " + minutes + "m " + seconds + "s";
  if (minutes > 0) return minutes + "m " + seconds + "s";
  return seconds + "s";
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const digits = scaled >= 100 ? 0 : 1;
  return scaled.toFixed(digits) + " " + units[index];
}

function formatNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return (number / 1000000).toFixed(1) + "M";
  if (number >= 1000) return (number / 1000).toFixed(1) + "k";
  return String(Math.round(number));
}

function timeAgo(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return "never";
  const diff = Date.now() - value;
  if (diff < 0) return "now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

function topDomain(state) {
  const domains = Object.values((state && state.domains) || {}).filter(
    (domain) => domain.domain !== "internal"
  );
  if (!domains.length) return null;
  domains.sort((a, b) => (b.activeMs || 0) - (a.activeMs || 0));
  return domains[0];
}
