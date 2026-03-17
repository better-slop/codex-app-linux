export function parseAppcastXml(xml) {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);

  if (!itemMatch) {
    throw new Error("No <item> found in appcast");
  }

  const item = itemMatch[1];
  const enclosureMatch = item.match(/<enclosure\s+([^>]+?)\/>/i);

  if (!enclosureMatch) {
    throw new Error("No <enclosure> found in appcast item");
  }

  return {
    title: getTagValue(item, "title"),
    pubDate: getTagValue(item, "pubDate"),
    version: getTagValue(item, "sparkle:shortVersionString"),
    buildNumber: getTagValue(item, "sparkle:version"),
    archiveUrl: getAttribute(enclosureMatch[1], "url"),
    archiveLength: getAttribute(enclosureMatch[1], "length")
  };
}

export async function fetchAppcastMetadata(appcastUrl) {
  const response = await fetch(appcastUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch appcast ${appcastUrl}: ${response.status} ${response.statusText}`
    );
  }

  const xml = await response.text();
  const parsed = parseAppcastXml(xml);

  return {
    ...parsed,
    appcastUrl
  };
}

function getTagValue(xml, tagName) {
  const matcher = new RegExp(`<${escapeTag(tagName)}>([\\s\\S]*?)<\\/${escapeTag(tagName)}>`, "i");
  const match = xml.match(matcher);

  if (!match) {
    throw new Error(`Missing <${tagName}> in appcast item`);
  }

  return decodeXml(match[1].trim());
}

function getAttribute(fragment, attributeName) {
  const matcher = new RegExp(`${escapeAttribute(attributeName)}="([^"]+)"`, "i");
  const match = fragment.match(matcher);

  if (!match) {
    throw new Error(`Missing ${attributeName} attribute`);
  }

  return decodeXml(match[1]);
}

function escapeTag(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttribute(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
