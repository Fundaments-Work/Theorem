use theorem_core::smart_shelves::{Book, Membership, Shelf};

#[tauri::command]
pub async fn evaluate_smart_shelves(
    books: Vec<Book>,
    shelves: Vec<Shelf>,
) -> Result<Box<[Membership]>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        theorem_core::smart_shelves::evaluate(&books, &shelves)
    })
    .await
    .map_err(|error| error.to_string())?
}
