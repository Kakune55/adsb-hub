import React, { useEffect, useState } from 'react';

function allowedURL(value, hosts) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && hosts.includes(url.host)) return url;
  } catch { /* Missing or malformed URL. */ }
  return null;
}

function findPhoto(data) {
  for (const page of data.query?.pages ?? []) {
    const info = page.imageinfo?.[0];
    const metadata = info?.extmetadata;
    const image = allowedURL(info?.thumburl, ['upload.wikimedia.org', 'thumb.wikimedia.org']);
    const source = allowedURL(info?.descriptionurl, ['commons.wikimedia.org']);
    const license = allowedURL(metadata?.LicenseUrl?.value, ['creativecommons.org']);
    if (metadata?.Restrictions?.value !== '' || !image || !source || !license ||
        !/^\/(licenses\/(by|by-sa)\/[1-4]\.0|publicdomain\/zero\/1\.0)\/?$/.test(license.pathname) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(info.mime)) continue;
    const author = new DOMParser().parseFromString(metadata.Attribution?.value || metadata.Artist?.value || '', 'text/html').body.textContent.trim();
    if (!author || !metadata.LicenseShortName?.value) continue;
    image.search = '';
    return { image: image.href, source: source.href, license: license.href, author, label: metadata.LicenseShortName.value };
  }
  return null;
}

export default function AircraftPhoto({ registration }) {
  const [photo, setPhoto] = useState(null);
  useEffect(() => {
    if (!/^[A-Z0-9-]{2,16}$/.test(registration ?? '')) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ action: 'query', generator: 'categorymembers',
      gcmtitle: `Category:${registration} (aircraft)`, gcmtype: 'file', gcmlimit: 12,
      prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '500',
      iiextmetadatafilter: 'Artist|Attribution|LicenseShortName|LicenseUrl|Restrictions',
      format: 'json', formatversion: '2', origin: '*',
    });
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data && !controller.signal.aborted) setPhoto(findPhoto(data)); })
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [registration]);
  if (!photo) return null;
  return <figure className="aircraft-photo">
    <a href={photo.source} target="_blank" rel="noreferrer"><img src={photo.image} alt={`${registration} 机身照片`}
      decoding="async" referrerPolicy="no-referrer" onError={() => setPhoto(null)} /></a>
    <figcaption><a href={photo.source} target="_blank" rel="noreferrer">{photo.author}</a>
      <a href={photo.license} target="_blank" rel="noreferrer">{photo.label}</a></figcaption>
  </figure>;
}
