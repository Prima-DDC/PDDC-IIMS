import { getCaseDocuments } from "./queries";
import { CaseDocumentsPanel } from "./DocumentForms";
import { DocumentTable, FolderList } from "./DocumentViews";

/**
 * The documents tab of a case file (PRD 7, screen 15).
 *
 * Its own server component so the case page can stream it, and it reads only
 * what the tab shows. The folder filter is a link rather than client state,
 * so a filtered view is a URL somebody can send to a colleague.
 */
export async function CaseDocumentsTab({
  caseRecordId,
  caseClassification,
  folderId,
}: {
  caseRecordId: string;
  caseClassification: string;
  folderId?: string;
}) {
  const documents = await getCaseDocuments(caseRecordId);

  const shown = folderId
    ? documents.documents.filter((document) => document.folderId === folderId)
    : documents.documents;

  return (
    <CaseDocumentsPanel
      caseRecordId={caseRecordId}
      caseClassification={caseClassification}
      folders={documents.folders}
      levels={documents.levels}
      summary={documents.summary}
      // Filing a document means uploading a file as well, and the storage
      // policy checks `documents:upload` on its own. Offering the form to
      // somebody with only `create` would offer a form whose first step the
      // bucket refuses.
      canCreate={documents.can.create && documents.can.upload}
    >
      <FolderList
        folders={documents.folders}
        caseRecordId={caseRecordId}
        activeFolderId={folderId}
      />
      <DocumentTable documents={shown} showCase={false} />
    </CaseDocumentsPanel>
  );
}
