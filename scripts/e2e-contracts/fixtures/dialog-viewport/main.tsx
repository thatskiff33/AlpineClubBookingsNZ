// Vite types the global stylesheet import below; tsconfig.e2e.json loads only Node types.
/// <reference types="vite/client" />
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CommandDialog, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import "@/app/globals.css";

function Fixture() {
  const { confirm, confirmDialog } = useConfirm();
  const [result, setResult] = React.useState("Waiting");
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  return (
    <main className="p-6 space-y-4">
      <h1>Dialog viewport regression</h1>
      <Button onClick={async () => setResult(await confirm({
        title: "Review changes",
        description: "Review the changes before confirming. ".repeat(16),
      }) ? "Confirmed" : "Cancelled")}>Open confirmation</Button>
      <p role="status">{result}</p>
      {confirmDialog}
      <Dialog>
        <DialogTrigger asChild><Button>Open capped dialog</Button></DialogTrigger>
        <DialogContent className="max-h-[90vh] flex flex-col" aria-describedby={undefined}>
          <DialogTitle>Existing height override</DialogTitle>
          <Select defaultValue="a">
            <SelectTrigger aria-label="Method"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="a">First method</SelectItem>
              <SelectItem value="b">Second method</SelectItem>
            </SelectContent>
          </Select>
        </DialogContent>
      </Dialog>
      <Button onClick={() => setPaletteOpen(true)}>Open commands</Button>
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <CommandInput aria-label="Search commands" />
        <CommandList>
          {Array.from({ length: 20 }, (_, i) => (
            <CommandItem key={i} onSelect={() => setPaletteOpen(false)}>Command {i + 1}</CommandItem>
          ))}
        </CommandList>
      </CommandDialog>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
