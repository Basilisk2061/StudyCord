const RAG2_CANDIDATE_EXTENSION = /\.(pdf|docx|txt)$/i;


export function isRag2CandidateFilename(filename) {
  return RAG2_CANDIDATE_EXTENSION.test(String(filename || '').trim());
}


export async function triggerAutomaticRag2Ingestion(request, attachmentId) {
  const safeAttachmentId = encodeURIComponent(String(attachmentId || '').trim());
  if (!safeAttachmentId) throw new Error('Attachment is required.');
  return request(`/api/rag2/attachments/${safeAttachmentId}/ingest`, {
    method: 'POST',
  });
}


export function startAutomaticRag2Ingestion(
  request,
  attachmentId,
  { onFailure = () => {} } = {},
) {
  void triggerAutomaticRag2Ingestion(request, attachmentId).catch(onFailure);
}
