<script lang="ts">
  import { browser } from "$app/environment";
  import { onMount } from "svelte";

  type ModalComponentProps = {
    show: boolean;
    title: string;
    message: string;
    onClose: () => void;
    onConfirm?: () => void;
  };

  const {
    show,
    title,
    message,
    onClose,
    onConfirm,
  }: ModalComponentProps = $props();

  let dialog: HTMLDialogElement;

  $effect(() => {
    if (browser && dialog) {
      if (show && !dialog.open) {
        dialog.showModal();
      } else if (!show && dialog.open) {
        dialog.close();
      }
    }
  });

  onMount(() => {
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);

    return () => {
      dialog.removeEventListener("cancel", handleCancel);
    };
  });

  const handleConfirm = () => {
    if (onConfirm) {
      onConfirm();
    }
    onClose();
  };
</script>

<dialog bind:this={dialog} onclose={onClose} class="modal-container">
  <div class="modal-content">
    <h3>{title}</h3>
    <p>{message}</p>
    <div class="modal-actions">
      {#if onConfirm}
        <button onclick={onClose} class="btn btn-secondary">Cancel</button>
        <button onclick={handleConfirm} class="btn btn-primary">Confirm</button>
      {:else}
        <button onclick={onClose} class="btn btn-primary">OK</button>
      {/if}
    </div>
  </div>
</dialog>

<style>
  .modal-container {
    border: none;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    padding: 0;
    max-width: 500px;
    width: 90%;
  }

  .modal-container::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
  }

  .modal-content {
    padding: 1.5rem 2rem;
  }

  h3 {
    font-size: 1.25rem;
    margin-top: 0;
    margin-bottom: 1rem;
    color: #333;
  }

  p {
    margin-bottom: 2rem;
    color: #555;
    line-height: 1.6;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  .btn {
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 4px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .btn-primary {
    background-color: #007bff;
    color: white;
  }

  .btn-primary:hover {
    background-color: #0056b3;
  }

  .btn-secondary {
    background-color: #f1f1f1;
    color: #333;
    border: 1px solid #ddd;
  }

  .btn-secondary:hover {
    background-color: #e0e0e0;
  }
</style> 