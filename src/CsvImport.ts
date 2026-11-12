import { App, ButtonComponent, Modal, Notice } from "obsidian";
import Booksidian from "main";
import { Book } from "src/Book";
import { goodreadsBooksFromCsv } from "src/csv";
import { downloadCover } from "src/CoverRefresher";

/**
 * Import a Goodreads "My Books" CSV export through the normal
 * Book/createFile pipeline: notes are created or updated exactly like
 * a feed sync (overwrite/preserve-body/id matching all apply).
 */
export async function importGoodreadsCsv(
	plugin: Booksidian,
	text: string,
): Promise<{ imported: number; failed: number; skipped: number }> {
	const shelfFilter = plugin.settings.goodreadsShelves
		.split(",")
		.map((shelf) => shelf.trim().toLowerCase())
		.filter((shelf) => shelf !== "");

	const allBooks = goodreadsBooksFromCsv(text);
	const feedBooks =
		shelfFilter.length === 0
			? allBooks
			: allBooks.filter((book) =>
					book.user_shelves
						.split(",")
						.map((shelf) => shelf.trim().toLowerCase())
						.some((shelf) => shelfFilter.includes(shelf)),
			  );
	const skipped = allBooks.length - feedBooks.length;

	const targetPath = plugin.settings.targetFolderPath || "./";

	let imported = 0;
	let failed = 0;

	for (const feedBook of feedBooks) {
		try {
			const book = new Book(plugin, feedBook);

			if (plugin.settings.coverDownload) {
				try {
					book.coverImage = await downloadCover(
						plugin,
						null,
						book.isbn || null,
						book.rawTitle || null,
						book.author || null,
						book.id,
					);
				} catch (error) {
					// A failed cover should not block importing the book.
					console.log(
						`Booksidian: cover for ${book.id} failed`,
						error,
					);
				}
			}

			await book.createFile(book, targetPath);
			imported++;
		} catch (error) {
			failed++;
			console.log(
				`Booksidian: failed to import "${feedBook.title}"`,
				error,
			);
		}
	}

	new Notice(
		`Booksidian: imported ${imported} book(s) from CSV${
			skipped ? `, skipped ${skipped} outside the configured shelves` : ""
		}${failed ? `, ${failed} failed (see console)` : ""}.`,
		8000,
	);

	return { imported, failed, skipped };
}

export class CsvImportModal extends Modal {
	private plugin: Booksidian;
	private selectedText: string | null = null;

	public constructor(app: App, plugin: Booksidian) {
		super(app);
		this.plugin = plugin;
	}

	public onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Booksidian: import Goodreads CSV" });
		contentEl.createEl("p", {
			text: "Export your library on Goodreads (My Books → Import & Export), then pick the CSV file here. Notes are created or updated like a normal sync; Overwrite and Preserve note body apply. Covers are downloaded when cover download is enabled.",
		});

		const input = contentEl.createEl("input", { type: "file" });
		input.accept = ".csv,text/csv";
		const status = contentEl.createEl("p", {
			text: "No file selected.",
		});

		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			if (!file) {
				this.selectedText = null;
				status.setText("No file selected.");
				return;
			}
			this.selectedText = await file.text();
			const count = goodreadsBooksFromCsv(this.selectedText).length;
			const shelves = this.plugin.settings.goodreadsShelves
				.split(",")
				.map((shelf) => shelf.trim())
				.filter((shelf) => shelf !== "");
			status.setText(
				`Selected ${file.name}: ${count} book(s)${
					shelves.length
						? `; only those on ${shelves.join(
								", ",
						  )} are imported (configured shelves)`
						: "; all rows are imported (no shelves configured)"
				}.`,
			);
		});

		const buttons = contentEl.createEl("div");
		buttons.style.display = "flex";
		buttons.style.gap = "0.5rem";
		buttons.style.marginTop = "0.5rem";

		new ButtonComponent(buttons)
			.setButtonText("Import")
			.setCta()
			.onClick(async () => {
				if (!this.selectedText) {
					new Notice("Booksidian: choose a CSV file first.");
					return;
				}
				this.close();
				await importGoodreadsCsv(this.plugin, this.selectedText);
			});
		new ButtonComponent(buttons)
			.setButtonText("Cancel")
			.onClick(() => this.close());
	}

	public onClose(): void {
		this.contentEl.empty();
	}
}
