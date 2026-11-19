const rvrPattern = /^R(\d{2}[LCR]?)\/([MP]?\d{4})(?:V([MP]?\d{4}))?(FT)?\/?([UDN])?$/;
const cloudPattern = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/;
const weatherPattern = /^[+-]?(?:VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS){1,3}$|^(?:TS|VCTS|VCSH)$/;

export function parseMETAR(raw) {
  // Stop before a trend forecast or remarks; those fields do not describe the observation.
  const tokens = (raw ?? '').trim().toUpperCase().replace(/=$/, '').split(/\s+/);
  const body = tokens.slice(tokens.findIndex((token) => /^\d{6}Z$/.test(token)) + 1);
  const end = body.findIndex((token) => /^(?:RMK|TEMPO|BECMG|NOSIG|PROB\d{2})$/.test(token));
  const observed = end === -1 ? body : body.slice(0, end);
  const rvr = [], clouds = [], phenomena = [];
  let visibility;
  for (const [i, token] of observed.entries()) {
    const range = token.match(rvrPattern);
    if (range) {
      const [, runway, min, max, feet, trend] = range;
      rvr.push({ runway, min, max, unit: feet ? 'ft' : 'm', trend });
    }
    const cloud = token.match(cloudPattern);
    if (cloud) clouds.push({ amount: cloud[1], feet: cloud[2] === '///' ? null : Number(cloud[2]) * 100, type: cloud[3] });
    if (weatherPattern.test(token)) phenomena.push(token);
    if (visibility) continue;
    if (token === 'CAVOK') visibility = '≥10 km · CAVOK';
    else if (/^\d{4}$/.test(token) && !/^\d\/\dSM$/.test(observed[i + 1] ?? '')) {
      const metres = Number(token);
      visibility = token === '9999' ? '≥10 km' : token === '0000' ? '<50 m' : metres < 1000 ? `${metres} m` : `${metres / 1000} km`;
    } else if (/^[MP]?(?:\d+|\d+\/\d+)SM$/.test(token)) {
      const whole = token.includes('/') && /^\d{1,2}$/.test(observed[i - 1]) ? `${observed[i - 1]} ` : '';
      visibility = `${whole}${token.slice(0, -2).replace(/^M/, '<').replace(/^P/, '>')} SM`;
    }
  }
  return { rvr, clouds, phenomena, visibility };
}

export function formatRVR({ min, max, unit, trend }) {
  const distance = (value) => `${value.startsWith('M') ? '<' : value.startsWith('P') ? '>' : ''}${Number(value.replace(/^[MP]/, ''))}`;
  const symbol = { U: ' ↑', D: ' ↓', N: ' →' }[trend] ?? '';
  return `${distance(min)}${max ? `–${distance(max)}` : ''} ${unit}${symbol}`;
}
