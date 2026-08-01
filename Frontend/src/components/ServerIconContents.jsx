import { useState } from 'react';
import { getServerIconPublicUrl } from '../lib/serverIcons';

function getServerInitials(name) {
  return name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export default function ServerIconContents({ server }) {
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = getServerIconPublicUrl(server.icon_path);

  if (iconUrl && !imageFailed) {
    return (
      <img
        className="server-icon__image"
        src={iconUrl}
        alt={`${server.name} icon`}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return <span className="server-icon__label">{getServerInitials(server.name)}</span>;
}
