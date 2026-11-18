const volumesPath = "/chapters/volumes";

export const newVolumeHref = `${volumesPath}/new`;

export function volumeHref(volumeId: string): string {
  return `${volumesPath}/${encodeURIComponent(volumeId)}`;
}

export function chapterHref(volumeId: string, chapterId: string): string {
  return `${volumeHref(volumeId)}/chapters/${encodeURIComponent(chapterId)}`;
}
