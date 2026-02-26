// System-wide constants and enums

// User Roles
export const USER_ROLES = {
  MASTER: 'master',
  ADMIN: 'admin',
  OPERADOR: 'operador',
  VIEWER: 'viewer'
};

// Role hierarchy for permission checks
export const ROLE_HIERARCHY = {
  [USER_ROLES.MASTER]: 4,
  [USER_ROLES.ADMIN]: 3,
  [USER_ROLES.OPERADOR]: 2,
  [USER_ROLES.VIEWER]: 1
};

// Agent Types
export const AGENT_TYPES = {
  TRIAGEM: 'triagem',
  ESPECIALISTA: 'especialista'
};

// Conversation Control
export const CONVERSATION_CONTROL = {
  IA: 'ia',
  HUMANO: 'humano'
};

// Conversation Status
export const CONVERSATION_STATUS = {
  ATIVO: 'ativo',
  FINALIZADO: 'finalizado',
  TIMEOUT: 'timeout'
};

// API Key Status
export const API_KEY_STATUS = {
  ATIVA: 'ativa',
  STANDBY: 'standby',
  RATE_LIMITED: 'rate_limited',
  ERRO: 'erro',
  DESATIVADA: 'desativada'
};

// API Key Providers
export const API_KEY_PROVIDERS = {
  GEMINI: 'gemini',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic'
};

// Subscription Status
export const SUBSCRIPTION_STATUS = {
  ATIVA: 'ativa',
  SUSPENSA: 'suspensa',
  CANCELADA: 'cancelada'
};

// Invoice Status
export const INVOICE_STATUS = {
  PENDENTE: 'pendente',
  PAGA: 'paga',
  ATRASADA: 'atrasada',
  CANCELADA: 'cancelada'
};

// Notification Severity
export const NOTIFICATION_SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

// Control History Actions
export const CONTROL_HISTORY_ACTIONS = {
  HUMANO_ASSUMIU: 'humano_assumiu',
  HUMANO_DEVOLVEU: 'humano_devolveu',
  TIMEOUT_IA_REASSUMIU: 'timeout_ia_reassumiu',
  ADMIN_FORCOU: 'admin_forcou'
};

// Subscription History Actions
export const SUBSCRIPTION_HISTORY_ACTIONS = {
  ADICIONOU_ITEM: 'adicionou_item',
  REMOVEU_ITEM: 'removeu_item',
  ALTEROU_QUANTIDADE: 'alterou_quantidade',
  MUDOU_PLANO: 'mudou_plano',
  MUDOU_FAIXA: 'mudou_faixa',
  DESCONTO_APLICADO: 'desconto_aplicado'
};

// Chatwoot Status
export const CHATWOOT_STATUS = {
  ATIVO: 'ativo',
  PROVISIONANDO: 'provisionando',
  ERRO: 'erro'
};

// HTTP Methods
export const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE'
};

// Message Direction
export const MESSAGE_DIRECTION = {
  ENTRADA: 'entrada',
  SAIDA: 'saida'
};

// Transfer Trigger Types
export const TRANSFER_TRIGGER_TYPES = {
  TOOL_RESULT: 'tool_result',
  KEYWORD: 'keyword',
  MENU_OPCAO: 'menu_opcao'
};

// Billing Types
export const BILLING_TYPES = {
  POR_FAIXA: 'por_faixa',
  PRECO_FIXO: 'preco_fixo'
};

// AI Providers
export const AI_PROVIDERS = {
  GOOGLE: 'google',
  CLAUDE: 'claude',
  GROK: 'grok',
};

// Models per provider (ordered: newest first)
export const PROVIDER_MODELS = {
  google: [
    // Gemini 3 series
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    // Gemini 2.5 series
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    // Gemini 2.0 series
    'gemini-2.0-pro-001',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    // Gemini 1.5 series (legacy)
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ],
  // claude: [],  // futuro
  // grok: [],    // futuro
};

// All allowed model values (flat list for validation)
export const ALL_MODELS = Object.values(PROVIDER_MODELS).flat();

// Default Models (backward compat)
export const DEFAULT_MODELS = {
  GEMINI_FLASH: 'gemini-2.0-flash-001',
  GEMINI_PRO: 'gemini-2.0-pro-001'
};

// Default Limits
export const DEFAULT_LIMITS = {
  MAX_TOKENS: 2048,
  TEMPERATURE: 0.3,
  MAX_FUNCTION_CALLS: 5,
  CONVERSATION_HISTORY_SIZE: 50,
  SESSION_TTL_SECONDS: 86400, // 24 hours
  API_TIMEOUT_MS: 30000,
  TOOL_TIMEOUT_MS: 30000,
  RATE_LIMIT_RETRY_SECONDS: 60,
  API_ERROR_RETRY_SECONDS: 30,
  HUMAN_INACTIVITY_TIMEOUT_MINUTES: 30
};

// Regex Patterns
export const REGEX_PATTERNS = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  PHONE: /^\+?[1-9]\d{1,14}$/,
  SLUG: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
};

// Error Codes
export const ERROR_CODES = {
  // Authentication Errors
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_USER_NOT_FOUND: 'AUTH_USER_NOT_FOUND',
  AUTH_USER_INACTIVE: 'AUTH_USER_INACTIVE',

  // Permission Errors
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TENANT_MISMATCH: 'TENANT_MISMATCH',

  // Resource Errors
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS: 'RESOURCE_ALREADY_EXISTS',
  RESOURCE_LIMIT_REACHED: 'RESOURCE_LIMIT_REACHED',

  // API Key Errors
  API_KEY_NOT_FOUND: 'API_KEY_NOT_FOUND',
  API_KEY_INVALID: 'API_KEY_INVALID',
  API_KEY_RATE_LIMITED: 'API_KEY_RATE_LIMITED',
  NO_KEYS_AVAILABLE: 'NO_KEYS_AVAILABLE',

  // Validation Errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_REQUEST: 'INVALID_REQUEST',

  // System Errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT'
};

// Success Messages
export const SUCCESS_MESSAGES = {
  CREATED: 'Resource created successfully',
  UPDATED: 'Resource updated successfully',
  DELETED: 'Resource deleted successfully',
  OPERATION_COMPLETED: 'Operation completed successfully'
};