import {
  putStudyOutput,
  validateStudyOutputContent,
} from './ragStudyOutputs.js';


export async function generateAndPersistStudyOutput({
  userId,
  sessionId,
  documentId,
  outputType,
  requestOutput,
  putStudyOutputFn = putStudyOutput,
  isActive = () => true,
  onDisplay = () => {},
  onPersistenceError = () => {},
  onRequestError = () => {},
}) {
  let content;
  try {
    content = await requestOutput();
    validateStudyOutputContent(outputType, content);
  } catch (error) {
    if (isActive()) onRequestError(error);
    return { content: null, error, persisted: false };
  }

  let persisted = true;
  try {
    await putStudyOutputFn(
      userId,
      sessionId,
      documentId,
      outputType,
      content,
    );
  } catch (error) {
    persisted = false;
    if (isActive()) onPersistenceError(error);
  }

  if (isActive()) onDisplay(content);
  return { content, error: null, persisted };
}
