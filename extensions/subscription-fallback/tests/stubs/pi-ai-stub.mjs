export function getModels(_providerId) {
  return [];
}

export const getBuiltinModels = getModels;

export async function loginAnthropic() {
  throw new Error('loginAnthropic is not used in subswitch regression tests');
}

export async function loginOpenAICodex() {
  throw new Error('loginOpenAICodex is not used in subswitch regression tests');
}

export async function refreshAnthropicToken() {
  throw new Error('refreshAnthropicToken is not used in subswitch regression tests');
}

export async function refreshOpenAICodexToken() {
  throw new Error('refreshOpenAICodexToken is not used in subswitch regression tests');
}

export function builtinProviders() {
  throw new Error('builtinProviders is not used in subswitch regression tests');
}
