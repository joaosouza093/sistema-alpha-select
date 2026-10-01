-- Fixa o search_path das funções que ainda não o definiam (recomendação do
-- Security Advisor do Supabase: "function_search_path_mutable"). Evita que
-- objetos homônimos em outro esquema sejam usados no lugar dos da aplicação.
alter function app.uid() set search_path = public, pg_temp;
alter function app.is_admin() set search_path = public, pg_temp;
alter function app.is_alpha() set search_path = public, pg_temp;
alter function app.can_view_process(uuid) set search_path = public, pg_temp;
alter function app.tg_touch() set search_path = public, pg_temp;
alter function app.tg_touch_version() set search_path = public, pg_temp;
alter function app.tg_append_only() set search_path = public, pg_temp;
alter function app.tg_users_guard() set search_path = public, pg_temp;
alter function app.tg_applications_guard() set search_path = public, pg_temp;
alter function app.tg_comments_guard() set search_path = public, pg_temp;
alter function app.tg_documents_guard() set search_path = public, pg_temp;
alter function app.tg_app_docs_guard() set search_path = public, pg_temp;
