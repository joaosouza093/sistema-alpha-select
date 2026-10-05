import type { DocumentRow } from '../api/types';
import { Modal } from './ui';

/**
 * Visualização somente para PDF e imagens, servidos pelo backend com
 * autorização a cada acesso. Demais formatos: apenas download protegido.
 */
export function DocumentPreview({ doc, onClose }: { doc: DocumentRow; onClose: () => void }) {
  const src = `/api/documents/${doc.id}/content`;
  const isImage = doc.mimeType === 'image/png' || doc.mimeType === 'image/jpeg';
  const isPdf = doc.mimeType === 'application/pdf';
  return (
    <Modal
      title={doc.name}
      onClose={onClose}
      size="lg"
      footer={
        <a className="btn btn-primary" href={`${src}?download=1`}>
          Baixar arquivo
        </a>
      }
    >
      {isPdf ? (
        <iframe title={`Visualização de ${doc.name}`} src={src} className="preview-frame" />
      ) : isImage ? (
        <img src={src} alt={`Visualização de ${doc.name}`} className="preview-img" />
      ) : (
        <p>Este formato não possui visualização segura no navegador. Use “Baixar arquivo”.</p>
      )}
    </Modal>
  );
}
