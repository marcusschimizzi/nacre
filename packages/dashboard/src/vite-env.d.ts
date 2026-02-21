/// <reference types="vite/client" />
/// <reference types="react" />

interface ImportMetaEnv {
  readonly VITE_NACRE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
