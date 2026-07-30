import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';
import {
  deleteResourceRating,
  handoffResourceToRag1,
  putResourceRating,
  rag1HandoffErrorMessage,
  ratingErrorMessage,
} from '../lib/rag2Api';
import ResourceAccessPanel from './ResourceAccessPanel';


export default function ResourceAccessWorkspace({
  resource,
  onBack,
  backLabel,
  onRatingSummary,
  onRag1Activated,
}) {
  const [ratingPending, setRatingPending] = useState(false);
  const [ratingError, setRatingError] = useState('');
  const controllerRef = useRef(null);
  const handoffControllerRef = useRef(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffError, setHandoffError] = useState('');

  useEffect(() => () => {
    controllerRef.current?.abort();
    handoffControllerRef.current?.abort();
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

  const useInRag1 = async () => {
    if (handoffPending) return;
    handoffControllerRef.current?.abort();
    const controller = new AbortController();
    handoffControllerRef.current = controller;
    setHandoffPending(true);
    setHandoffError('');
    try {
      const activation = await handoffResourceToRag1(
        apiRequest,
        resource.resource_id,
        { signal: controller.signal },
      );
      onRag1Activated(activation);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setHandoffError(rag1HandoffErrorMessage(error));
      }
    } finally {
      if (handoffControllerRef.current === controller) {
        handoffControllerRef.current = null;
        setHandoffPending(false);
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
      handoffPending={handoffPending}
      handoffError={handoffError}
      onUseInRag1={useInRag1}
    />
  );
}
