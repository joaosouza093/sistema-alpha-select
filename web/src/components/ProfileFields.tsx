import { SelectField, TextField } from './ui';
import { UFS, educationLabel, educationStatusLabel } from '../lib/format';

/** Campos do perfil do candidato (iguais aos nomes da API). */
export interface ProfileValues {
  birthDate: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressDistrict: string;
  city: string;
  state: string;
  postalCode: string;
  desiredRole: string;
  linkedinUrl: string;
  educationLevel: string;
  course: string;
  institution: string;
  educationStatus: string;
}

export const emptyProfile: ProfileValues = {
  birthDate: '', addressStreet: '', addressNumber: '', addressComplement: '', addressDistrict: '', city: '', state: '',
  postalCode: '', desiredRole: '', linkedinUrl: '', educationLevel: '', course: '', institution: '', educationStatus: '',
};

/** Valores vindos da API (null) → campos do formulário (''). */

/** Campos do formulário → corpo da API ('' vira null). */
export const profilePayload = (p: ProfileValues) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.trim() ? v.trim() : null])) as Record<keyof ProfileValues, string | null>;

/** O que o formulário público exige (pedido da Alpha Select). */
export const PORTAL_REQUIRED: (keyof ProfileValues)[] = ['birthDate', 'city', 'state', 'postalCode', 'desiredRole', 'educationLevel'];
export const portalProfileComplete = (p: ProfileValues) => PORTAL_REQUIRED.every((k) => p[k].trim());

const maskCep = (v: string) => {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

export const profileFrom = (o: Partial<Record<keyof ProfileValues, string | null | undefined>>): ProfileValues => {
  const p = Object.fromEntries(Object.keys(emptyProfile).map((k) => [k, o[k as keyof ProfileValues] ?? ''])) as unknown as ProfileValues;
  return { ...p, postalCode: maskCep(p.postalCode) };
};

export function ProfileFields({ value, onChange, errors = {}, required = false, framed = true, sections = ['personal', 'address', 'professional', 'education'] }: {
  value: ProfileValues;
  onChange: (v: ProfileValues) => void;
  errors?: Record<string, string>;
  /** true = portal: marca e exige os campos obrigatórios. */
  required?: boolean;
  sections?: ('personal' | 'address' | 'professional' | 'education')[];
  /** false = a formação sai sem moldura (quando a página já tem o título "Formação"). */
  framed?: boolean;
}) {
  const set = (k: keyof ProfileValues) => (e: { target: { value: string } }) =>
    onChange({ ...value, [k]: k === 'postalCode' ? maskCep(e.target.value) : e.target.value });
  const req = (k: keyof ProfileValues) => required && PORTAL_REQUIRED.includes(k);
  const opt = (k: keyof ProfileValues) => (required && !PORTAL_REQUIRED.includes(k) ? 'Opcional.' : undefined);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      {sections.includes('personal') && (
        <TextField label="Data de nascimento" type="date" value={value.birthDate} onChange={set('birthDate')} max={today} min="1900-01-01"
          required={req('birthDate')} error={errors.birthDate} autoComplete="bday" />
      )}
      {sections.includes('address') && (
        <fieldset className="question">
          <legend>Endereço</legend>
          <div className="stack">
            <div className="grid grid-3">
              <TextField label="CEP" value={value.postalCode} onChange={set('postalCode')} inputMode="numeric" maxLength={9}
                required={req('postalCode')} error={errors.postalCode} autoComplete="postal-code" />
              <TextField label="Cidade" value={value.city} onChange={set('city')} maxLength={120} required={req('city')} error={errors.city} autoComplete="address-level2" />
              <SelectField label="Estado (UF)" value={value.state} onChange={set('state')} required={req('state')} error={errors.state}>
                <option value="">Selecione</option>
                {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
              </SelectField>
            </div>
            <div className="grid grid-2">
              <TextField label="Rua" value={value.addressStreet} onChange={set('addressStreet')} maxLength={160} hint={opt('addressStreet')} error={errors.addressStreet} autoComplete="address-line1" />
              <div className="grid grid-2">
                <TextField label="Número" value={value.addressNumber} onChange={set('addressNumber')} maxLength={20} hint={opt('addressNumber')} error={errors.addressNumber} />
                <TextField label="Complemento" value={value.addressComplement} onChange={set('addressComplement')} maxLength={80} hint={opt('addressComplement')} error={errors.addressComplement} autoComplete="address-line2" />
              </div>
            </div>
            <TextField label="Bairro" value={value.addressDistrict} onChange={set('addressDistrict')} maxLength={80} hint={opt('addressDistrict')} error={errors.addressDistrict} />
          </div>
        </fieldset>
      )}
      {sections.includes('professional') && (
        <div className="grid grid-2">
          <TextField label="Cargo / Área de interesse" value={value.desiredRole} onChange={set('desiredRole')} maxLength={120}
            required={req('desiredRole')} error={errors.desiredRole} />
          <TextField label="LinkedIn" value={value.linkedinUrl} onChange={set('linkedinUrl')} maxLength={300} placeholder="linkedin.com/in/seu-perfil"
            hint={opt('linkedinUrl')} error={errors.linkedinUrl} />
        </div>
      )}
      {sections.includes('education') && (() => {
        const fields = (
          <div className="grid grid-2">
            <SelectField label="Escolaridade" value={value.educationLevel} onChange={set('educationLevel')} required={req('educationLevel')} error={errors.educationLevel}>
              <option value="">Selecione</option>
              {Object.entries(educationLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
            <SelectField label="Status" value={value.educationStatus} onChange={set('educationStatus')} hint={opt('educationStatus')} error={errors.educationStatus}>
              <option value="">—</option>
              {Object.entries(educationStatusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
            <TextField label="Curso" value={value.course} onChange={set('course')} maxLength={120} hint={opt('course')} error={errors.course} />
            <TextField label="Instituição de ensino" value={value.institution} onChange={set('institution')} maxLength={160} hint={opt('institution')} error={errors.institution} />
          </div>
        );
        return framed ? <fieldset className="question"><legend>Formação</legend>{fields}</fieldset> : fields;
      })()}
    </>
  );
}
