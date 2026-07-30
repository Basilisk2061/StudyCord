import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import {
  deleteResourceRating,
  putResourceRating,
  ratingErrorMessage,
} from '../lib/rag2Api';
import ResourceAccessPanel from './ResourceAccessPanel';


export default function ResourceAccessWorkspace({
  resource,
  onBack,
  backLabel,
  onRatingSummary,
}) {
  const [ratingPending, setRatingPending] = useState(false);
  const [ratingError, setRatingError] = useState('');
  const controllerRef = useRef(null);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, [resource.resource_id]);

  const mutateRating = async (rating) => {
    if (ratingPending) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRatingPending(true);
    setRatingError('');

    try {
      const summary = rating == null
        ? await deleteResourceRating(
            apiRequest,
            resource.resource_id,
            { signal: controller.signal },
          )
        : await putResourceRating(
            apiRequest,
            resource.resource_id,
            rating,
            { signal: controller.signal },
          );
      onRatingSummary(summary);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setRatingError(ratingErrorMessage(error));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRatingPending(false);
      }
    }
  };

  return (
    <ResourceAccessPanel
      key={resource.resource_id}
      resource={resource}
      ratingPending={ratingPending}
      ratingError={ratingError}
      onRate={(_, rating) => mutateRating(rating)}
      onClearRating={() => mutateRating(null)}
      onBack={onBack}
      backLabel={backLabel}
    />
  );
}
