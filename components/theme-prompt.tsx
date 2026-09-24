'use client';

import { Moon, Sun } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** One-time first-visit choice; the persistent switch remains in Settings & connections. */
export function ThemePrompt({
  open,
  onChoose,
}: {
  open: boolean;
  onChoose: (darkMode: boolean) => void;
}) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="theme-prompt">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Moon />
          </AlertDialogMedia>
          <AlertDialogTitle>Would you like dark mode?</AlertDialogTitle>
          <AlertDialogDescription>
            Use a softer charcoal appearance for Brief. You can change this
            later in Settings & connections.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onChoose(false)}>
            <Sun />
            Keep light
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => onChoose(true)}>
            <Moon />
            Use dark mode
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
