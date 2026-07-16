export function selectActiveBookId(books, requestedBookId) {
  const activeBooks = books.filter((book) => book.status !== "archived");
  return activeBooks.some((book) => book.id === requestedBookId)
    ? requestedBookId
    : activeBooks[0]?.id ?? null;
}
