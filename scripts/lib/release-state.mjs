export function summarizeChannelReleaseState({
  channel,
  packageVersion,
  publishedVersion = null
}) {
  return {
    channel: channel.name,
    distTag: channel.distTag,
    packageVersion,
    publishedVersion,
    outdated: packageVersion !== publishedVersion
  };
}
