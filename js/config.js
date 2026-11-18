// Remplace ces deux valeurs par celles de ton projet Supabase
// (Supabase > Project Settings > API).
// La clé "anon" est publique par conception : la sécurité repose
// sur les règles RLS du fichier supabase/schema.sql.
export const SUPABASE_URL = "https://zqosxqaswotfjdfqbhqr.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_7wsHRQoe6ZsL8qkoExwIzw_8TUUjGlu";

// Verrouillage automatique du coffre après inactivité (minutes)
export const VAULT_AUTOLOCK_MIN = 5;
// Effacement du presse-papiers après copie d'un mot de passe (secondes)
export const CLIPBOARD_CLEAR_SEC = 30;
