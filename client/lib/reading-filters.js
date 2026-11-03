// The web client hands downloads to the browser. It has no device file inventory.
// Server files, old download flags and another device's metadata are not proof.
export function deviceDownloadState() { return 'unverified' }
export function ownershipLabel(book) { return { owned: 'Owned', unowned: 'Unowned' }[book.ownership] || 'Ownership not specified' }
export function filterReadingBooks(books, { statuses, ownership = 'all', downloads = 'all', showRemoved = false }) {
  return books.filter(book => {
    if (book.deleted && !showRemoved) return false
    return statuses.includes(book.status) && (ownership === 'all' || (book.ownership || 'unspecified') === ownership) && (downloads === 'all' || deviceDownloadState(book) === downloads)
  })
}
