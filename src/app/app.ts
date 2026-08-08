import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { VaultService } from './core/vault/vault.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly vaultService = inject(VaultService);

  async ngOnInit(): Promise<void> {
    await this.vaultService.initialize();
  }
}
